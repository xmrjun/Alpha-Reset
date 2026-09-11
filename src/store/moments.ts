import type { BreakoutMoment } from '../types.js';
import type { StoreDatabase } from './db.js';

export function createMomentStore(db: StoreDatabase) {
  const upsert = db.prepare(`
    INSERT INTO breakout_moments (ca, moment, bar_time, price, detected_at)
    VALUES (@ca, @moment, @barTime, @price, @detectedAt)
    ON CONFLICT (ca, moment) DO UPDATE SET
      bar_time = excluded.bar_time, price = excluded.price, detected_at = excluded.detected_at
    WHERE excluded.bar_time > breakout_moments.bar_time
      OR (excluded.bar_time = breakout_moments.bar_time AND excluded.price > breakout_moments.price)
  `);
  const select = db.prepare(`SELECT moment, bar_time AS barTime, price
    FROM breakout_moments WHERE ca = ? ORDER BY moment`);
  return {
    upsertMoments: db.transaction((ca: string, moments: BreakoutMoment[], detectedAt: number): void => {
      for (const moment of moments) upsert.run({ ...moment, ca, detectedAt });
    }),
    getMoments(ca: string): BreakoutMoment[] {
      return select.all(ca) as BreakoutMoment[];
    },
  };
}
