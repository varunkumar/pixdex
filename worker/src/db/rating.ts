// One 1-10 quality score that blends the vision model's aesthetic_score with the
// owner's 1-5 star rating (stars * 2). A human rating dominates; the model score
// still nudges it. Without a human rating the model score is used as is.
export const USER_WEIGHT = 0.7;

/** SQL expression over a photos row (or a CTE exposing the same columns). */
export const COMBINED_SCORE_SQL = `(CASE WHEN user_rating IS NULL THEN aesthetic_score
  ELSE ${USER_WEIGHT} * user_rating * 2 + ${1 - USER_WEIGHT} * COALESCE(aesthetic_score, user_rating * 2) END)`;

export function combinedScore(row: { user_rating?: number | null; aesthetic_score?: number | null }): number | null {
  if (row.user_rating == null) return row.aesthetic_score ?? null;
  const stars = row.user_rating * 2;
  return USER_WEIGHT * stars + (1 - USER_WEIGHT) * (row.aesthetic_score ?? stars);
}
