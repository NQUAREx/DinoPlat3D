-- Keep the already-deployed RPC validation in step with the client and Edge API.
do $$
declare
  definition text;
  old_rule text := 'nick !~ ''^[[:alnum:]_-]+$''';
  new_rule text := 'nick !~ ''^[[:alnum:]_ -]+$''';
begin
  select pg_get_functiondef('public.game_action(text,text,jsonb)'::regprocedure)
    into definition;
  if position(old_rule in definition) = 0 then
    raise exception 'Expected nickname validation not found in public.game_action';
  end if;
  definition := replace(definition, old_rule, new_rule);
  execute definition;
end
$$;
