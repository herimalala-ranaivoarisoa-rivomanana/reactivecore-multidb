ALTER TABLE public.items ADD UNIQUE (tenant_id, id);

CREATE TABLE public.charges (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    item_id UUID NOT NULL,
    period CHAR(7) NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id)
);

CREATE INDEX charges_tenant_period_item ON public.charges (tenant_id, period, item_id);
ALTER TABLE public.charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.charges FORCE ROW LEVEL SECURITY;
CREATE POLICY charges_scope ON public.charges TO reactivecore_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON public.charges TO reactivecore_app;
