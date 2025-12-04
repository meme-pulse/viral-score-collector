ALTER TABLE "pair_pools" ALTER COLUMN "token_x_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pair_pools" ALTER COLUMN "token_y_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pair_pools" ADD COLUMN "bin_step" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE INDEX "pair_token_addresses_idx" ON "pair_pools" USING btree ("token_x_address","token_y_address");