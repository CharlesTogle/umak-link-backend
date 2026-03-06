export const PHILIPPINE_TIMEZONE = 'Asia/Manila';
const PHILIPPINE_UTC_OFFSET = '+08:00';

function getPhilippineDateTimeParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHILIPPINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second'),
  };
}

export function getPhilippineNowIso(): string {
  const parts = getPhilippineDateTimeParts(new Date());
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${PHILIPPINE_UTC_OFFSET}`;
}
