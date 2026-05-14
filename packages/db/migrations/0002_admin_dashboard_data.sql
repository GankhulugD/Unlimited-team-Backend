ALTER TABLE `products` ADD `sku` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `products` ADD `category` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `products` ADD `size` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `products` ADD `status` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `inventory` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `sales_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `products` ADD `revenue` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `created_at` text DEFAULT (datetime('now')) NOT NULL;
--> statement-breakpoint
CREATE TABLE `store_categories` (
	`store_id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`store_id`, `name`),
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
