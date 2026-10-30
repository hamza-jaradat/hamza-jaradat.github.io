// Every tunable number in the music analysis, with the values the game ships. The
// benchmark (`npm run bench -- --tune`, see bench/) searches around these on labeled songs.
export const DEFAULT_PARAMS = {
  // Onsets, per layer (kick, snare, hats, tones). A layer's scale never falls below
  // `onsetShare` of the loudest layer's, nor below its absolute floor (flux units), so
  // faint noise isn't scaled up into hits. A peak must stand `sharp*` times above its
  // neighborhood: real attacks are impulsive, swells and beating are not.
  onsetShare: 0.35,
  floorKick: 0.35,
  floorSnare: 0.15,
  floorHat: 0.05,
  floorTone: 0.04,
  sharpKick: 2,
  sharpSnare: 1.8,
  sharpHat: 1.8,
  sharpTone: 1.5,

  // Beats. The onset envelope weighs each layer against the kick (1); off-beat hats would
  // pull the grid sideways. Tempo has a log-normal prior around `tempoCenter` BPM,
  // `tempoWidth` octaves wide. `tightness` is how strictly beats keep to the tempo. A
  // steady grid replaces the tracked beats when `gridAgreement` of them sit within
  // `gridTolerance` seconds of one.
  envSnare: 0.8,
  envHat: 0.2,
  envTone: 0.5,
  tempoCenter: 120,
  tempoWidth: 0.9,
  tightness: 300,
  gridTolerance: 0.06,
  gridAgreement: 0.7,

  // Bars: evidence for a downbeat (a chord change, a kick, no backbeat snare), and the
  // cost of re-syncing the bar count when it keeps disagreeing.
  barChord: 2,
  barKick: 0.4,
  barSnare: 0.8,
  barResync: 5,

  // Structure: the lowest novelty that marks a section boundary, the energy jump that
  // does too, the shortest section (bars), and what makes a drop: a rise into the peak
  // (in energy or in bass), a real beat after it, and the bass or the drums coming in.
  noveltyFloor: 0.05,
  energyJump: 0.2,
  minBars: 3,
  dropRise: 0.12,
  dropLowRise: 0.15,
  dropDrums: 0.2,
  dropDrumsJump: 0.25,
  dropLowJump: 0.2,
};
