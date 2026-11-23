-- What the model said before each step (its THOUGHT, or its separate reasoning), so a
-- reviewer can follow why the agent ran what it ran. Null for steps written before this
-- column, and for a reply with no text besides its action.
alter table steps add column thought text;
