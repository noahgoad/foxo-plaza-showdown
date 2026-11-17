const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONDAY = Date.UTC(1970, 0, 5);
const DURATION = 2 * 3_600_000;

const schedule = [
  { day: 2, hour: 12, mode: 'hunt', title: 'Trait Hunt Rematch' },
  { day: 4, hour: 12, mode: 'boss', title: 'Boss Squad Night' },
  { day: 6, hour: 12, mode: 'trials', title: 'Daily Trial Meetup' },
];

export function communityEvents(now = Date.now()) {
  const week = MONDAY + Math.floor((now - MONDAY) / WEEK) * WEEK;
  return schedule.map(({ day, hour, mode, title }) => {
    let startsAt = week + day * DAY + hour * 3_600_000;
    if (startsAt + DURATION <= now) startsAt += WEEK;
    const endsAt = startsAt + DURATION;
    return { id: mode + ':' + startsAt, mode, title, startsAt, endsAt, open: startsAt <= now };
  }).sort((a, b) => a.startsAt - b.startsAt);
}
