ALTER TABLE public.items ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
GRANT UPDATE (version) ON public.items TO reactivecore_app;
