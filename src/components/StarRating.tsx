import type { CSSProperties } from 'react';
import { MAX_STARS } from '../game/stars';

interface StarRatingProps {
  label: string;
  value?: number;
  progress?: readonly number[];
  className?: string;
}

export function StarRating({ label, value = 0, progress, className = '' }: StarRatingProps) {
  return (
    <span className={`star-rating ${className}`.trim()} role="img" aria-label={label}>
      {Array.from({ length: MAX_STARS }, (_, index) => {
        const fill = progress?.[index] ?? (index < value ? 1 : 0);
        return (
          <i
            className="star-rating-star"
            key={index}
            style={{ '--star-fill': Math.min(1, Math.max(0, fill)) } as CSSProperties}
            aria-hidden="true"
          ><span /></i>
        );
      })}
    </span>
  );
}
