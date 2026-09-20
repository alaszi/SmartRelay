CREATE TYPE "public"."event_source" AS ENUM('http', 'email', 'telegram_callback', 'test');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('RECEIVED', 'QUEUED', 'PROCESSING', 'SUCCESS', 'FAILED', 'HELD_NO_CREDIT', 'EXPIRED', 'DROPPED_LOOP', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('topup', 'charge', 'adjustment', 'refund');--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe');--> statement-breakpoint
CREATE TYPE "public"."pricing_kind" AS ENUM('relay_http', 'calendar_event', 'sms_dispatch');--> statement-breakpoint
CREATE TYPE "public"."relay_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."relay_type" AS ENUM('webhook_sms', 'email_api', 'chat_relay', 'calendar_bridge');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sms_mode" AS ENUM('byo', 'managed');--> statement-breakpoint
CREATE TYPE "public"."topup_status" AS ENUM('pending', 'paid', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_micro" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "credit_ledger_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"delta_micro" bigint NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text NOT NULL,
	"balance_after_micro" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "credit_ledger_delta_sign" CHECK (("credit_ledger"."kind" = 'topup' AND "credit_ledger"."delta_micro" > 0)
        OR ("credit_ledger"."kind" = 'charge' AND "credit_ledger"."delta_micro" < 0)
        OR ("credit_ledger"."kind" IN ('adjustment', 'refund') AND "credit_ledger"."delta_micro" <> 0))
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "delivery_attempts_event_attempt_unique" UNIQUE("event_id","attempt_no")
);
--> statement-breakpoint
CREATE TABLE "event_payloads" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"payload_in" jsonb,
	"payload_out" jsonb,
	"response_excerpt" text,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "event_payloads_excerpt_size" CHECK ("event_payloads"."response_excerpt" IS NULL OR octet_length("event_payloads"."response_excerpt") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relay_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "event_source" NOT NULL,
	"status" "event_status" DEFAULT 'RECEIVED' NOT NULL,
	"dedupe_hash" text,
	"held_until" timestamp with time zone,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"final_status_code" integer,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_user_dedupe_unique" UNIQUE("user_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"account_email" text NOT NULL,
	"refresh_token" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_connections_account_unique" UNIQUE("user_id","provider","account_email")
);
--> statement-breakpoint
CREATE TABLE "pricing" (
	"kind" "pricing_kind" PRIMARY KEY NOT NULL,
	"price_micro" bigint NOT NULL,
	CONSTRAINT "pricing_price_positive" CHECK ("pricing"."price_micro" > 0)
);
--> statement-breakpoint
CREATE TABLE "processed_provider_events" (
	"provider" "payment_provider" NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_provider_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "relay_email_addresses" (
	"relay_id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	CONSTRAINT "relay_email_addresses_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "relays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "relay_type" NOT NULL,
	"status" "relay_status" DEFAULT 'active' NOT NULL,
	"ingest_token" text NOT NULL,
	"config_public" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_secret" text,
	"sms_mode" "sms_mode" DEFAULT 'byo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_triggered_at" timestamp with time zone,
	CONSTRAINT "relays_ingest_token_unique" UNIQUE("ingest_token")
);
--> statement-breakpoint
CREATE TABLE "scheduled_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"relay_id" uuid NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_session_id" text,
	"amount_cents" integer NOT NULL,
	"status" "topup_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topups_provider_session_id_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "topups_amount_positive" CHECK ("topups"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"timezone" text DEFAULT 'Europe/Bucharest' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_payloads" ADD CONSTRAINT "event_payloads_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_relay_id_relays_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_email_addresses" ADD CONSTRAINT "relay_email_addresses_relay_id_relays_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relays" ADD CONSTRAINT "relays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reminders" ADD CONSTRAINT "scheduled_reminders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reminders" ADD CONSTRAINT "scheduled_reminders_relay_id_relays_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_user_seq_idx" ON "credit_ledger" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "event_payloads_purge_after_idx" ON "event_payloads" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "events_user_received_idx" ON "events" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "events_relay_received_idx" ON "events" USING btree ("relay_id","received_at");--> statement-breakpoint
CREATE INDEX "events_status_held_until_idx" ON "events" USING btree ("status","held_until");--> statement-breakpoint
CREATE INDEX "events_relay_dedupe_idx" ON "events" USING btree ("relay_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "relays_user_id_idx" ON "relays" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scheduled_reminders_status_run_at_idx" ON "scheduled_reminders" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "topups_user_id_idx" ON "topups" USING btree ("user_id");