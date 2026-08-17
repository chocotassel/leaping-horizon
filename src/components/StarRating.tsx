import { Fragment, type CSSProperties } from 'react';
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
        const fill = Math.min(1, Math.max(0, progress?.[index] ?? (index < value ? 1 : 0)));
        return (
          <Fragment key={index}>
            <i
              className="star-rating-star"
              style={{ '--star-fill': fill } as CSSProperties}
              aria-hidden="true"
            ><span /></i>
            {progress && index < MAX_STARS - 1 && (
              <i
                className="star-rating-connector"
                style={{ '--connector-fill': fill === 1 ? 1 : 0 } as CSSProperties}
                aria-hidden="true"
              ><span /></i>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}
