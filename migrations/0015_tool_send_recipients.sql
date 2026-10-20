-- 0015 (C276c): a catalog tool the entry labels as a send (`firstContact`) records WHERE its recipients are in the input
-- (JSON array of pointers such as "body.recipients"; [] = Connect cannot see them, so every call is a first contact).
-- NULL for every other tool (name-based send tools keep the top-level recipient arguments of X-02).
ALTER TABLE connect_tools ADD COLUMN send_recipients TEXT;
