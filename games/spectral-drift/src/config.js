// Shared gameplay constants.

export const LANES = 5;
export const LANE_WIDTH = 1.6;
export const LANE_SPAN = LANES * LANE_WIDTH;
export const TRACK_MARGIN = 0.45;
export const TRACK_HALF_WIDTH = LANE_SPAN / 2 + TRACK_MARGIN;
export const MAX_X = ((LANES - 1) / 2) * LANE_WIDTH;

export const LEAD_IN = 3.5; // seconds of road before the music starts
export const TAIL = 9; // seconds of road after the music ends
export const TRACK_RATE = 60; // track samples per second of song time

export const laneX = (lane) => (lane - (LANES - 1) / 2) * LANE_WIDTH;

export const KIND = { NOTE: 0, POWER: 1, HAZARD: 2 };
export const STATE = { PENDING: 0, COLLECTED: 1, MISSED: 2, HIT: 3, PASSED: 4, SMASHED: 5 };
export const HOLD = { WAITING: 0, HOLDING: 1, DONE: 2, DROPPED: 3 };

// perBar: notes per 4-beat bar from the calmest to the most intense bars.
// maxLevel: the finest beat division charted (0 downbeats, 1 beats, 2 eighths,
// 3 sixteenths and triplets, 4 off the grid); a strong accent may go one finer.
export const DIFFICULTIES = {
  chill: { id: 'chill', label: 'Chill', perBar: [1.5, 4], maxLevel: 1, minGap: 0.24, holdMin: 0.5, hazard: 0.05, speed: 0.9 },
  normal: { id: 'normal', label: 'Normal', perBar: [2.5, 7], maxLevel: 2, minGap: 0.16, holdMin: 0.45, hazard: 0.11, speed: 1.0 },
  intense: { id: 'intense', label: 'Intense', perBar: [3.5, 12], maxLevel: 4, minGap: 0.11, holdMin: 0.4, hazard: 0.18, speed: 1.12 },
};

export const OVERDRIVE_DURATION = 8;
