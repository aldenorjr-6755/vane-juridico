import clsx, { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...classes: ClassValue[]) => twMerge(clsx(...classes));

export const formatTimeDifference = (
  date1: Date | string,
  date2: Date | string,
): string => {
  date1 = new Date(date1);
  date2 = new Date(date2);

  const diffInSeconds = Math.floor(
    Math.abs(date2.getTime() - date1.getTime()) / 1000,
  );

  if (diffInSeconds < 60)
    return `${diffInSeconds} segundo${diffInSeconds !== 1 ? 's' : ''}`;
  else if (diffInSeconds < 3600)
    return `${Math.floor(diffInSeconds / 60)} minuto${Math.floor(diffInSeconds / 60) !== 1 ? 's' : ''}`;
  else if (diffInSeconds < 86400)
    return `${Math.floor(diffInSeconds / 3600)} hora${Math.floor(diffInSeconds / 3600) !== 1 ? 's' : ''}`;
  else if (diffInSeconds < 31536000)
    return `${Math.floor(diffInSeconds / 86400)} dia${Math.floor(diffInSeconds / 86400) !== 1 ? 's' : ''}`;
  else
    return `${Math.floor(diffInSeconds / 31536000)} ano${Math.floor(diffInSeconds / 31536000) !== 1 ? 's' : ''}`;
};
