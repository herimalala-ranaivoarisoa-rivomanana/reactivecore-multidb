BEGIN;

ALTER TABLE public.reactive_tenant_clocks
    ADD COLUMN pruned_through BIGINT NOT NULL DEFAULT 0 CHECK (pruned_through BETWEEN 0 AND last_seq);

ALTER TABLE public.mutation_execution_receipts
    ADD COLUMN response_expired BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX receipt_retention_candidates ON public.mutation_execution_receipts
    (tenant_id, created_at) WHERE NOT response_expired AND commit_seq IS NOT NULL;

COMMIT;
