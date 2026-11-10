export interface Env {
  DB: D1Database;
  THUMBNAILS: R2Bucket;
  INGEST_TOKEN: string;
  READ_TOKEN: string;
  /** Email of the default owner (unrestricted access); set as a Worker var or secret. */
  OWNER_EMAIL: string;
}
