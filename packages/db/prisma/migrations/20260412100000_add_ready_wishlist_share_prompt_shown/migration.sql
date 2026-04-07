DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserProfile' AND column_name = 'readyWishlistSharePromptShown') THEN
    ALTER TABLE "UserProfile" ADD COLUMN "readyWishlistSharePromptShown" BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;
