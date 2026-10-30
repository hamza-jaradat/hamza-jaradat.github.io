// Genres a song can be played as. Each has a name and a line about it for the ready
// screen, says what the analysis should expect of the music (overrides of
// analysis/params.js), and how its road and chart play:
//
//   chart.density  notes per bar           chart.holds    how long a tone must ring to be a
//   chart.drums    weight of kick & snare                 hold (higher: fewer holds)
//   chart.tones    weight of tonal onsets  chart.hazards  how many hazards
//   chart.hats     weight of hi-hats       chart.melody   whether lanes may follow the melody
//   chart.swing    how readily a bar plays as triplets (lower: sooner)
//   chart.sway     how much wider (+) or narrower (-) rhythmic lanes sway
//   chart.phrase   bars between power notes in the song's peaks
//   track.speed, track.bends, track.hills: how fast, how winding and how hilly the road is
//   track.bounce   rolling hills in time with the bars
//   track.drama    how hard build-ups climb and drops dive
//   track.react    how hard the road thumps, twists and ripples with the drums
//
// "any" assumes nothing: it is how the game played before genres.

const NEUTRAL = {
  params: {},
  chart: { density: 1, drums: 1, tones: 0.95, hats: 0.55, holds: 1, hazards: 1, melody: true, swing: 1.5, sway: 0, phrase: 8 },
  track: { speed: 1, bends: 1, hills: 1, bounce: 1, drama: 1, react: 1 },
};

const genre = (label, about, { params = {}, chart = {}, track = {} } = {}) => ({
  label,
  about,
  params,
  chart: { ...NEUTRAL.chart, ...chart },
  track: { ...NEUTRAL.track, ...track },
});

export const GENRES = {
  any: genre('Any', 'No genre style: the music alone shapes the road.'),
  hiphop: genre('Hip-hop', 'Lanes bounce on kick and snare, the road thumps hardest with the drums and rolls with the bars. Few holds and hazards.', {
    params: { tempoCenter: 92 },
    chart: { drums: 1.1, tones: 0.85, holds: 1.5, hazards: 0.7, melody: false, swing: 1 },
    track: { speed: 0.94, bends: 0.85, bounce: 2.4, drama: 0.8, react: 1.5 },
  }),
  rock: genre('Rock', 'Faster and denser, with wide lane swings, hazards everywhere and more power notes.', {
    params: { tempoCenter: 140 },
    chart: { density: 1.15, hats: 0.45, hazards: 1.45, sway: 1, phrase: 4 },
    track: { speed: 1.1, bends: 1.25, hills: 1.15, bounce: 0.7, react: 1.15 },
  }),
  electronic: genre('Electronic', 'Build-ups climb higher and drops dive deeper.', {
    params: { tempoCenter: 126 },
    chart: { density: 1.05 },
    track: { speed: 1.04, drama: 1.35, react: 1.25 },
  }),
  pop: genre('Pop', 'Notes follow the vocal line, with fewer hazards.', {
    params: { tempoCenter: 112 },
    chart: { drums: 0.9, tones: 1.05, holds: 0.9, hazards: 0.8 },
    track: { react: 0.9 },
  }),
  ambient: genre('Ambient', 'A slow road of long waves: fewer notes, long holds, hardly any hazards.', {
    params: { tempoCenter: 90 },
    chart: { density: 0.75, drums: 0.85, tones: 1.1, holds: 0.75, hazards: 0.3, sway: -1 },
    track: { speed: 0.85, bends: 0.75, hills: 0.85, bounce: 1.5, drama: 0.45, react: 0.35 },
  }),
};

// What a genre tag (ID3, Vorbis comment, MP4) says, as one of GENRES, or null. Names that
// mix two genres go by the first rule they match.
const RULES = [
  ['electronic', /hardcore techno|happy hardcore|hardstyle|drum.?(and|&|n).?bass|\bdnb\b|\bd&b\b|future bass|electro.?house/],
  ['pop', /indie.?pop|synth.?pop|dance.?pop|electro.?pop|\bk-?pop|\bj-?pop|pop.?rock|power pop|britpop/],
  ['hiphop', /hip.?hop|\brap\b|\btrap\b|drill|grime|gangsta|boom.?bap|g-funk|crunk|phonk/],
  ['rock', /rock|metal|punk|grunge|(?<!s)core\b|\bemo\b|altern|\bindie\b|shoegaze|djent|screamo|crossover|new wave|gothic|industrial|noise|thrash|post-/],
  ['electronic', /electr|\bedm\b|dance|house|techno|trance|dubstep|jungle|garage|breakbeat|big beat|rave|club|bass|synthwave|\bidm\b|\bebm\b|goa|psytrance/],
  ['ambient', /ambient|chill|lo-?fi|downtempo|lounge|new age|classical|soundtrack|\bscore\b|piano|meditat|instrumental|acoustic|folk|jazz|easy listening|orchestra|baroque|opera|symphon|sonata|chamber|psybient|illbient|bossa/],
  ['pop', /pop|r&b|\brnb\b|soul|funk|disco|latin|reggae|country|ballad|top 40|vocal|gospel|motown|swing/],
];

export function genreFromTag(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const [key, re] of RULES) if (re.test(t)) return key;
  return null;
}
