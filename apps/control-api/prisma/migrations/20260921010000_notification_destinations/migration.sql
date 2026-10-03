-- Where HookuBit tells a human that something went wrong, per PROJECT.
CREATE TYPE "NotificationKind" AS ENUM ('email', 'slack');
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'confirmed', 'failing', 'disabled');

CREATE TABLE "notification_destinations" (
  "id"           TEXT NOT NULL,
  "project_id"   TEXT NOT NULL,
  "kind"         "NotificationKind" NOT NULL,
  "target"       TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "status"       "NotificationStatus" NOT NULL DEFAULT 'pending',
  "events"       TEXT[] NOT NULL DEFAULT '{}',
  "confirmed_at" TIMESTAMP(3),
  "last_sent_at" TIMESTAMP(3),
  "last_error"   TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_destinations_pkey" PRIMARY KEY ("id")
);

-- One channel cannot be added twice and then receive everything twice.
CREATE UNIQUE INDEX "notification_destinations_project_id_kind_target_key"
  ON "notification_destinations" ("project_id", "kind", "target");
CREATE INDEX "notification_destinations_project_id_idx"
  ON "notification_destinations" ("project_id");

ALTER TABLE "notification_destinations"
  ADD CONSTRAINT "notification_destinations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One message sent, or deliberately not sent. This table IS the grouping rule:
-- without a record of what was already said, "do not repeat yourself within
-- thirty minutes" is not expressible.
CREATE TABLE "notification_dispatches" (
  "id"             TEXT NOT NULL,
  "destination_id" TEXT NOT NULL,
  "event"          TEXT NOT NULL,
  -- The DEDUPLICATION key, not an email subject line: it names the thing that
  -- happened, so two endpoints failing are two messages and one endpoint
  -- failing twice is one.
  "subject"        TEXT NOT NULL,
  "occurrences"    INTEGER NOT NULL DEFAULT 1,
  "first_at"       TIMESTAMP(3) NOT NULL,
  "last_at"        TIMESTAMP(3) NOT NULL,
  "sent_at"        TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_dispatches_pkey" PRIMARY KEY ("id")
);

-- The arbiter for the grouping upsert.
CREATE UNIQUE INDEX "notification_dispatches_destination_id_subject_key"
  ON "notification_dispatches" ("destination_id", "subject");
CREATE INDEX "notification_dispatches_destination_id_last_at_idx"
  ON "notification_dispatches" ("destination_id", "last_at");

ALTER TABLE "notification_dispatches"
  ADD CONSTRAINT "notification_dispatches_destination_id_fkey"
  FOREIGN KEY ("destination_id") REFERENCES "notification_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The confirmation link's token, hashed. The raw token exists in exactly one
-- place — the message that was sent — which is what makes clicking the link
-- proof that whoever clicked it can read the address.
--
-- Not a `user_tokens` row: that table is keyed by user, and the whole point of
-- a group address is that the person who confirms it may have no account here.
ALTER TABLE "notification_destinations"
  ADD COLUMN "confirmation_token_hash" TEXT,
  ADD COLUMN "confirmation_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "notification_destinations_confirmation_token_hash_key"
  ON "notification_destinations" ("confirmation_token_hash");
