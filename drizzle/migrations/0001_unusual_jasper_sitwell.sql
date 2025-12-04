CREATE TABLE "token_score_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_symbol" varchar(32) NOT NULL,
	"avg_score" integer NOT NULL,
	"max_score" integer NOT NULL,
	"min_score" integer NOT NULL,
	"snapshot_date" timestamp NOT NULL,
	"total_posts" integer DEFAULT 0,
	"total_views" integer DEFAULT 0,
	"total_likes" integer DEFAULT 0,
	"total_reposts" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_score_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_symbol" varchar(32) NOT NULL,
	"score" integer NOT NULL,
	"snapshot_hour" timestamp NOT NULL,
	"raw_posts" integer DEFAULT 0,
	"raw_views" integer DEFAULT 0,
	"raw_likes" integer DEFAULT 0,
	"raw_reposts" integer DEFAULT 0,
	"raw_replies" integer DEFAULT 0,
	"raw_unique_users" integer DEFAULT 0,
	"avg_bonding_curve" real DEFAULT 0,
	"graduated_ratio" real DEFAULT 0,
	"image_ratio" real DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "token_score_daily_token_date_idx" ON "token_score_daily" USING btree ("token_symbol","snapshot_date");--> statement-breakpoint
CREATE INDEX "token_score_daily_date_idx" ON "token_score_daily" USING btree ("snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "token_score_snapshots_token_hour_idx" ON "token_score_snapshots" USING btree ("token_symbol","snapshot_hour");--> statement-breakpoint
CREATE INDEX "token_score_snapshots_hour_idx" ON "token_score_snapshots" USING btree ("snapshot_hour");