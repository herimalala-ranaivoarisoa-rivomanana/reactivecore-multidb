BEGIN;

DO $$
DECLARE
    append_function_owner NAME;
BEGIN
    SELECT pg_get_userbyid(proowner)
    INTO STRICT append_function_owner
    FROM pg_proc
    WHERE oid = 'public.reactive_append_changes(jsonb)'::regprocedure;

    EXECUTE format(
        'CREATE POLICY change_log_tenant_append ON public.reactive_change_log
         FOR INSERT TO %I
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
        append_function_owner
    );
END
$$;

COMMIT;
