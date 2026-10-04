import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

const pad = (n: number) => String(n).padStart(2, '0');

/** The device's calendar day as YYYY-MM-DD, in its own time zone (not UTC). */
export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's local date, updated at midnight and whenever the app returns to the foreground. */
export function useLocalDay(): string {
  const [day, setDay] = useState(() => localDateKey());

  useEffect(() => {
    const refresh = () => setDay(localDateKey());
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 1, 0);
    const timer = setTimeout(refresh, midnight.getTime() - now.getTime());
    return () => {
      subscription.remove();
      clearTimeout(timer);
    };
  }, [day]);

  return day;
}
