export interface Env {
  DB: D1Database;
  THUMBNAILS: R2Bucket;
  INGEST_TOKEN: string;
  READ_TOKEN: string;
  ADMIN_EMAIL: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ACCESS_GROUP_ID: string;
  ENROLL_LIMITER?: RateLimit;
}
