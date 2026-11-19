ALTER TABLE public.items ADD COLUMN reserved_by UUID;
GRANT UPDATE (reserved_by) ON public.items TO reactivecore_app;
