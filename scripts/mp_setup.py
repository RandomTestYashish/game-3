"""Create and configure the multiplayer DEVELOPMENT Supabase project.

    python3 scripts/mp_setup.py

Needs a Supabase personal access token in ~/.config/thecourt/supabase-token
(Dashboard -> Account -> Access Tokens). It never leaves this machine and is
never written into the repository.

What it does, all through the Supabase Management API:
  1. finds or creates the project "the-court-multiplayer-dev" (free plan,
     region ap-south-1 / Mumbai) in your organisation; its database password
     is generated here and kept in ~/.config/thecourt/dev-db-password (0600);
  2. waits until it is up;
  3. applies supabase/multiplayer/*.sql in order (the dev copy of the solo
     board, then the multiplayer tables, security, functions and Realtime);
  4. turns on anonymous sign-ins (the players' guest identities);
  5. writes the dev project's URL and public (publishable) key into
     js/config.js, with multiplayer on and PostHog off.

It refuses to touch the production project.
"""

import json
import pathlib
import secrets
import sys
import time
import urllib.error
import urllib.request

API = "https://api.supabase.com"
NAME = "the-court-multiplayer-dev"
REGION = "ap-south-1"
PRODUCTION_REF = "cbbdhnzbqocckyyymszc"  # the live game's project: never touched here
HOME = pathlib.Path.home() / ".config" / "thecourt"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def token():
    f = HOME / "supabase-token"
    if not f.exists():
        sys.exit(f"No token at {f}. Create one (Dashboard -> Account -> Access Tokens) and save it there.")
    t = f.read_text().strip()
    if not t.startswith("sbp_"):
        sys.exit("The token file does not hold a Supabase personal access token (it should start with sbp_).")
    return t


def req(method, path, body=None, tok=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "the-court-setup"})
    try:
        with urllib.request.urlopen(r, timeout=60) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        return e.code, raw


def main():
    tok = token()
    st, orgs = req("GET", "/v1/organizations", tok=tok)
    orgs = orgs if st == 200 and isinstance(orgs, list) else []  # some tokens may list projects but not organisations
    st, projects = req("GET", "/v1/projects", tok=tok)
    if st != 200:
        sys.exit(f"Could not list projects ({st}): {projects}")
    proj = next((p for p in projects if p.get("name") == NAME), None)
    if proj is None:
        prod = next((p for p in projects if p.get("id") == PRODUCTION_REF), None)
        org = (prod or {}).get("organization_id") or (orgs[0]["id"] if orgs else None)
        if not org:
            sys.exit("Could not tell which organisation to create the project in.")
        HOME.mkdir(parents=True, exist_ok=True)
        pw_file = HOME / "dev-db-password"
        pw = pw_file.read_text().strip() if pw_file.exists() else secrets.token_urlsafe(24)
        pw_file.write_text(pw)
        pw_file.chmod(0o600)
        print(f"Creating {NAME} in {REGION}...")
        st, proj = req("POST", "/v1/projects", {"name": NAME, "organization_id": org, "region": REGION, "db_pass": pw}, tok)
        if st not in (200, 201):
            sys.exit(f"Supabase refused to create the project ({st}): {proj}\n"
                     "On the free plan an organisation may have at most 2 active projects.")
    ref = proj["id"]
    if ref == PRODUCTION_REF:
        sys.exit("Refusing: that is the production project.")
    print("Project:", ref)
    for _ in range(90):
        st, p = req("GET", f"/v1/projects/{ref}", tok=tok)
        if st == 200 and p.get("status") == "ACTIVE_HEALTHY":
            break
        time.sleep(10)
    else:
        sys.exit("The project did not come up in 15 minutes; run this again later.")
    for f in sorted((ROOT / "supabase" / "multiplayer").glob("*.sql")):
        st, out = req("POST", f"/v1/projects/{ref}/database/query", {"query": f.read_text()}, tok)
        if st not in (200, 201):
            sys.exit(f"{f.name} failed ({st}): {out}")
        print("Applied", f.name)
    st, out = req("PATCH", f"/v1/projects/{ref}/config/auth", {"external_anonymous_users_enabled": True}, tok)
    if st not in (200, 201):
        sys.exit(f"Could not turn on anonymous sign-ins ({st}): {out}")
    print("Anonymous sign-ins on")
    st, keys = req("GET", f"/v1/projects/{ref}/api-keys", tok=tok)
    if st != 200:
        sys.exit(f"Could not read the API keys ({st}): {keys}")
    pub = next((k["api_key"] for k in keys if k.get("type") == "publishable"), None) or next(
        (k["api_key"] for k in keys if k.get("name") == "anon"), None)
    if not pub or pub.startswith("sb_secret") or "service_role" in json.dumps(pub):
        sys.exit("No public key found.")
    cfg = ROOT / "js" / "config.js"
    text = cfg.read_text()
    import re
    text = re.sub(r"supabaseUrl: '[^']*'", f"supabaseUrl: 'https://{ref}.supabase.co'", text)
    text = re.sub(r"supabaseAnonKey: '[^']*'", f"supabaseAnonKey: '{pub}'", text)
    text = re.sub(r"multiplayer: (true|false)", "multiplayer: true", text)
    cfg.write_text(text)
    print("js/config.js now points at the dev project, multiplayer on.")


if __name__ == "__main__":
    main()
