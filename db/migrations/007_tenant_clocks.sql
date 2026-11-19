BEGIN;

CREATE TABLE public.reactive_tenant_clocks (
    tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id),
    last_seq BIGINT NOT NULL CHECK (last_seq >= 0)
);

-- Preserve the old sequence floor across live clients and all stored receipts.
INSERT INTO public.reactive_tenant_clocks (tenant_id, last_seq)
SELECT tenant.id, clock.last_seq
FROM public.tenants AS tenant CROSS JOIN public.reactive_commit_clock AS clock;

ALTER TABLE public.reactive_tenant_clocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_clock_read ON public.reactive_tenant_clocks
    FOR SELECT TO reactivecore_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON public.reactive_tenant_clocks TO reactivecore_app;

ALTER TABLE public.reactive_change_log DROP CONSTRAINT reactive_change_log_pkey,
    ADD PRIMARY KEY (tenant_id, seq, ordinal);
DROP INDEX public.idx_change_log_tenant_seq;

CREATE OR REPLACE FUNCTION public.reactive_append_changes(changes JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    tenant UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    boundary BIGINT;
BEGIN
    IF tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant context is required';
    END IF;
    IF changes IS NULL OR jsonb_typeof(changes) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Expected an array of changes';
    END IF;
    IF jsonb_array_length(changes) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Expected between 1 and 100 changes';
    END IF;

    INSERT INTO public.reactive_tenant_clocks AS clock (tenant_id, last_seq)
    VALUES (tenant, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET last_seq = clock.last_seq + 1
    RETURNING last_seq INTO STRICT boundary;

    INSERT INTO public.reactive_change_log
        (seq, ordinal, event_id, tenant_id, table_name, document_id, operation)
    SELECT boundary, position - 1, (change->>'eventId')::uuid, tenant,
           change->>'table', (change->>'documentId')::uuid, change->>'operation'
    FROM jsonb_array_elements(changes) WITH ORDINALITY AS entries(change, position);

    RETURN boundary;
END;
$$;

COMMIT;
