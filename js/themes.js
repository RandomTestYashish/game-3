// Court themes: eight country environments, a Black Court surface on every
// third court, and the player's choice between automatic rotation and one
// fixed country. Visual only: nothing here touches the rules.
//
//   country  = floor((court - 1) / 2) % 8   Japan, New York, London, India,
//                                           Paris, Cairo, Rio, Sydney
//   black    = court % 3 === 0              independent of the country

export const COUNTRIES = [
  {
    id: 'japan',
    name: 'JAPAN',
    title: 'SAKURA COURT',
    short: 'SAKURA COURT',
    accent: '#F5A6C8',
    court: { court: '#315E45', alt: '#3E7455', lines: '#E9E8C6' },
    black: { court: '#090D12', alt: '#111923', lines: '#F2B4D0' },
    bg: {
      sky: ['#171B3B', '#24204d', '#3d2660', '#6e2d6c', '#a8407a', '#D75A78', '#f7a0a8'],
      sun: { x: -54, lift: 16, r: 9, c: '#ffd0d8', band: '#f59ab0', glow: '#ffc0d0' },
      clouds: ['#3a2a5c', '#b9566f'],
      hills: ['#2a2a52', '#1d2b3a'],
      trees: { dark: '#123D2B', hi: '#2a6044', shade: '#0b2a1d', bush: '#163f2b', bushHi: '#21573a' },
      blossom: ['#c8679a', '#e88bb4', '#F5A6C8', '#fbd0e2'],
      wall: { base: '#5a5560', top: '#8a8492', top2: '#6f6a77', line: '#46424c', speck: ['#68636e', '#504c56'], pillar: '#6c6672', pillarTop: '#948d9a' },
      lamp: '#FFC96B',
    },
    ambient: { petals: '#F5A6C8', petalsHi: '#fbd0e2', petalRate: 1.6, fireflies: true },
  },
  {
    id: 'newyork',
    name: 'NEW YORK',
    title: 'CITY LIGHTS',
    short: 'CITY LIGHTS',
    accent: '#FF9B4A',
    court: { court: '#244F43', alt: '#315F51', lines: '#E7E7CF' },
    black: { court: '#070A10', alt: '#101722', lines: '#8CD9FF' },
    bg: {
      sky: ['#10182F', '#1b2350', '#2f2a5e', '#73306a', '#c2464f', '#E95B4B', '#FF9B4A'],
      sun: { x: 40, lift: 10, r: 12, c: '#ffc76a', band: '#ff9b4a', glow: '#ffb35c' },
      clouds: ['#33284f', '#c45a4f'],
      hills: ['#22263f', '#181e30'],
      trees: { dark: '#10261f', hi: '#1f4636', shade: '#09180f', bush: '#13291f', bushHi: '#1d3d2c' },
      wall: { base: '#4d4a4c', top: '#7c777a', top2: '#615d60', line: '#3b393b', speck: ['#5a5759', '#444143'], pillar: '#5f5b5e', pillarTop: '#87828a' },
      lamp: '#FFC76A',
    },
    ambient: { petals: null, petalRate: 0, fireflies: true },
  },
  {
    id: 'london',
    name: 'LONDON',
    title: 'CLASSIC GARDEN',
    short: 'CLASSIC GARDEN',
    accent: '#D77C63',
    court: { court: '#24553A', alt: '#326744', lines: '#E8E4C9' },
    black: { court: '#080B0C', alt: '#131916', lines: '#F0C68B' },
    bg: {
      sky: ['#171C35', '#252649', '#393051', '#584266', '#7a5070', '#a0607a', '#d49a8a'],
      clouds: ['#3b3352', '#8b5a6a'],
      hills: ['#2a2c45', '#1d2d2a'],
      trees: { dark: '#15301f', hi: '#2c5a38', shade: '#0f2417', bush: '#1a3d26', bushHi: '#225030' },
      wall: { base: '#77736D', top: '#9c978d', top2: '#86817a', line: '#5f5b55', speck: ['#827d75', '#69655f'], pillar: '#86817a', pillarTop: '#a8a297' },
      lamp: '#FFC66B',
    },
    ambient: { petals: '#f1eedd', petalsHi: '#d9c9c0', petalRate: 0.8, fireflies: true },
  },
  {
    id: 'india',
    name: 'INDIA',
    title: 'JAIPUR ROYAL COURT',
    short: 'ROYAL COURT',
    accent: '#FFAD5C',
    court: { court: '#42653A', alt: '#527642', lines: '#F2E4BD' },
    black: { court: '#0B0A0A', alt: '#1A1412', lines: '#FFD19A' },
    bg: {
      sky: ['#241B39', '#4a2142', '#79394F', '#b44a42', '#D75E3E', '#f08a3e', '#FFC46E'],
      sun: { x: -20, lift: 8, r: 15, c: '#ffe08a', band: '#ffad5c', glow: '#ffc96b' },
      clouds: ['#4d2a48', '#d0704a'],
      hills: ['#5a3446', '#3b2a33'],
      trees: { dark: '#1d3a22', hi: '#3a6a34', shade: '#132816', bush: '#24442a', bushHi: '#335f36' },
      wall: { base: '#B97750', top: '#E0AE78', top2: '#c98d60', line: '#94593a', speck: ['#c48860', '#a5684a'], pillar: '#c98d60', pillarTop: '#E0AE78' },
      lamp: '#FFC96B',
    },
    ambient: { petals: '#FFAD5C', petalsHi: '#ffd19a', petalRate: 0.7, fireflies: true },
  },
  {
    id: 'paris',
    name: 'PARIS',
    title: 'EIFFEL EVENING',
    short: 'EIFFEL EVENING',
    accent: '#B9A0E8',
    court: { court: '#2F5A4A', alt: '#3B6B58', lines: '#ECE6D2' },
    black: { court: '#08090F', alt: '#12141F', lines: '#C8B4F0' },
    bg: {
      sky: ['#141633', '#22244f', '#3a3268', '#5e4282', '#8c5a94', '#c27f9c', '#f0b8a4'],
      sun: { x: 46, lift: 12, r: 10, c: '#ffd8c0', band: '#f2a890', glow: '#ffc8b0' },
      clouds: ['#2e2c58', '#a56c8e'],
      hills: ['#2c2c50', '#20263a'],
      trees: { dark: '#17321f', hi: '#2e5c3a', shade: '#0e2216', bush: '#1b3e27', bushHi: '#265433' },
      wall: { base: '#8a8478', top: '#b4ad9e', top2: '#9c9688', line: '#6c675d', speck: ['#958f82', '#7a756a'], pillar: '#9c9688', pillarTop: '#bdb6a6' },
      lamp: '#FFD98A',
    },
    ambient: { petals: '#e9d8f4', petalsHi: '#c8b4f0', petalRate: 0.6, fireflies: true },
  },
  {
    id: 'cairo',
    name: 'CAIRO',
    title: 'DESERT SUN',
    short: 'DESERT SUN',
    accent: '#F2C14E',
    court: { court: '#4A6A3A', alt: '#5A7B47', lines: '#F4E6C0' },
    black: { court: '#0C0A08', alt: '#1A1510', lines: '#F2C14E' },
    bg: {
      sky: ['#13203F', '#22305a', '#3f3d6a', '#7a4c62', '#c0684a', '#e8944a', '#FFD27A'],
      sun: { x: -36, lift: 6, r: 16, c: '#fff0b0', band: '#ffc45c', glow: '#ffd27a' },
      clouds: ['#2f3560', '#d08a5a'],
      hills: ['#b9814e', '#9a6a40'],
      trees: { dark: '#2a4a24', hi: '#4a7a36', shade: '#1a3016', bush: '#2e5028', bushHi: '#3f6a32' },
      wall: { base: '#C9A06A', top: '#E8C890', top2: '#d6b07a', line: '#a07a4a', speck: ['#d2aa74', '#b48a58'], pillar: '#d6b07a', pillarTop: '#ecd09a' },
      lamp: '#FFC96B',
    },
    ambient: { petals: '#e8c98a', petalsHi: '#fff0c8', petalRate: 0.5, fireflies: false },
  },
  {
    id: 'rio',
    name: 'RIO',
    title: 'SUGARLOAF BAY',
    short: 'SUGARLOAF BAY',
    accent: '#3FD6B0',
    court: { court: '#1F5E4A', alt: '#2A705A', lines: '#E6F0DA' },
    black: { court: '#060C0C', alt: '#0F1A1A', lines: '#3FD6B0' },
    bg: {
      sky: ['#0E1E3A', '#163460', '#2a4a7a', '#7a4a86', '#d0567a', '#f8885c', '#ffc86a'],
      sun: { x: 30, lift: 4, r: 13, c: '#ffe0a0', band: '#ff9c5c', glow: '#ffb870' },
      clouds: ['#2a3a6a', '#d8707a'],
      hills: ['#1e3a4a', '#163030'],
      trees: { dark: '#0f3a26', hi: '#1f6a40', shade: '#082818', bush: '#124a2c', bushHi: '#1c6a3c' },
      wall: { base: '#E0D6C0', top: '#F4ECDA', top2: '#e8dfca', line: '#b8ad96', speck: ['#d6cbb2', '#c4b89e'], pillar: '#e8dfca', pillarTop: '#fff6e4' },
      lamp: '#FFD27A',
    },
    ambient: { petals: null, petalRate: 0, fireflies: true },
  },
  {
    id: 'sydney',
    name: 'SYDNEY',
    title: 'HARBOUR LIGHTS',
    short: 'HARBOUR LIGHTS',
    accent: '#7FC8F8',
    court: { court: '#245848', alt: '#306a58', lines: '#E8EEE0' },
    black: { court: '#05090F', alt: '#0D1520', lines: '#7FC8F8' },
    bg: {
      sky: ['#0C1630', '#14244c', '#22386a', '#3c4e86', '#7a6a9a', '#c4889a', '#f4b496'],
      sun: { x: -48, lift: 10, r: 10, c: '#ffe2c0', band: '#f4a888', glow: '#ffd0b0' },
      clouds: ['#22305c', '#9a7a9c'],
      hills: ['#1e2a48', '#152038'],
      trees: { dark: '#16382a', hi: '#2c5e44', shade: '#0c241a', bush: '#18402c', bushHi: '#22563a' },
      wall: { base: '#6e6a66', top: '#9a958e', top2: '#827d77', line: '#55524e', speck: ['#78736d', '#605c58'], pillar: '#827d77', pillarTop: '#a6a098' },
      lamp: '#FFE0A0',
    },
    ambient: { petals: null, petalRate: 0, fireflies: true },
  },
];

export const BY_ID = Object.fromEntries(COUNTRIES.map((c) => [c.id, c]));

// 'auto' rotates with the court number; a country id fixes that country.
export const THEME_CHOICES = ['auto', ...COUNTRIES.map((c) => c.id)];
export const cleanThemeChoice = (v) => (THEME_CHOICES.includes(v) ? v : 'auto');

export const autoCountryIndex = (court) => Math.floor((court - 1) / 2) % COUNTRIES.length;
export const isBlackCourt = (court) => court % 3 === 0;

// shift turns the automatic rotation by that many countries; the game picks
// a new one on every visit, so each load opens on a different country.
export function getCourtTheme(courtNumber, choice = 'auto', shift = 0) {
  const court = Math.max(1, Math.floor(courtNumber) || 1);
  const pick = cleanThemeChoice(choice);
  const c = pick === 'auto' ? COUNTRIES[(autoCountryIndex(court) + shift) % COUNTRIES.length] : BY_ID[pick];
  const black = isBlackCourt(court);
  const surface = black ? c.black : c.court;
  return {
    key: c.id + (black ? ':black' : ''),
    mode: pick === 'auto' ? 'auto' : 'manual',
    countryId: c.id,
    countryName: c.name,
    title: c.title,
    isBlackCourt: black,
    courtPalette: surface,
    backgroundPalette: c.bg,
    courtLineColor: surface.lines,
    accentColor: c.accent,
    ambientEffects: c.ambient,
  };
}
