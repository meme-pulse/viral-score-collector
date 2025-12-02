CREATE TABLE "memex_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"memex_post_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"user_name" varchar(64),
	"user_is_pre_ordered" boolean DEFAULT false,
	"content_type" varchar(16) NOT NULL,
	"view_count" integer DEFAULT 0,
	"like_count" integer DEFAULT 0,
	"repost_count" integer DEFAULT 0,
	"reply_count" integer DEFAULT 0,
	"bonding_curve_progress" real DEFAULT 0,
	"price_fluctuation_range" real DEFAULT 0,
	"token_cex_listed" boolean DEFAULT false,
	"has_image" boolean DEFAULT false,
	"mentioned_tokens" text,
	"extracted_tickers" text,
	"extracted_hashtags" text,
	"post_created_at" timestamp NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memex_posts_memex_post_id_unique" UNIQUE("memex_post_id")
);
--> statement-breakpoint
CREATE TABLE "merkle_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"root" varchar(66) NOT NULL,
	"epoch" integer NOT NULL,
	"pool_count" integer NOT NULL,
	"tree_data" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merkle_checkpoints_epoch_unique" UNIQUE("epoch")
);
--> statement-breakpoint
CREATE TABLE "pair_pools" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" varchar(66) NOT NULL,
	"token_x_symbol" varchar(32) NOT NULL,
	"token_y_symbol" varchar(32) NOT NULL,
	"token_x_address" varchar(42),
	"token_y_address" varchar(42),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pair_pools_pool_id_unique" UNIQUE("pool_id")
);
--> statement-breakpoint
CREATE TABLE "pair_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" varchar(66) NOT NULL,
	"token_x_symbol" varchar(32) NOT NULL,
	"token_y_symbol" varchar(32) NOT NULL,
	"token_x_score" integer NOT NULL,
	"token_y_score" integer NOT NULL,
	"pair_score" integer NOT NULL,
	"timestamp" bigint NOT NULL,
	"nonce" bigint NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_symbol" varchar(32) NOT NULL,
	"score" integer NOT NULL,
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
CREATE UNIQUE INDEX "memex_post_id_idx" ON "memex_posts" USING btree ("memex_post_id");--> statement-breakpoint
CREATE INDEX "memex_post_created_at_idx" ON "memex_posts" USING btree ("post_created_at");--> statement-breakpoint
CREATE INDEX "memex_bonding_curve_idx" ON "memex_posts" USING btree ("bonding_curve_progress");--> statement-breakpoint
CREATE UNIQUE INDEX "merkle_epoch_idx" ON "merkle_checkpoints" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "merkle_root_idx" ON "merkle_checkpoints" USING btree ("root");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_pool_id_idx" ON "pair_pools" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "pair_tokens_idx" ON "pair_pools" USING btree ("token_x_symbol","token_y_symbol");--> statement-breakpoint
CREATE INDEX "pair_scores_pool_id_idx" ON "pair_scores" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "pair_scores_timestamp_idx" ON "pair_scores" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "pair_scores_pool_timestamp_idx" ON "pair_scores" USING btree ("pool_id","timestamp");--> statement-breakpoint
CREATE INDEX "token_scores_symbol_idx" ON "token_scores" USING btree ("token_symbol");--> statement-breakpoint
CREATE INDEX "token_scores_created_at_idx" ON "token_scores" USING btree ("created_at");