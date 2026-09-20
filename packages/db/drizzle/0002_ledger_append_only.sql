-- credit_ledger is append-only. The only allowed change to an existing row is anonymization:
-- user_id set to NULL (what ON DELETE SET NULL does when a user is deleted). Every other column
-- must stay identical, and rows can never be deleted.
CREATE FUNCTION credit_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_ledger is append-only: DELETE is not allowed';
  END IF;

  IF NEW.user_id IS NOT NULL
     OR (NEW.seq, NEW.id, NEW.delta_micro, NEW.kind, NEW.ref_type, NEW.ref_id,
         NEW.idempotency_key, NEW.balance_after_micro, NEW.created_at)
        IS DISTINCT FROM
        (OLD.seq, OLD.id, OLD.delta_micro, OLD.kind, OLD.ref_type, OLD.ref_id,
         OLD.idempotency_key, OLD.balance_after_micro, OLD.created_at)
  THEN
    RAISE EXCEPTION 'credit_ledger is append-only: only anonymizing user_id is allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_guard_trigger
BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION credit_ledger_guard();
