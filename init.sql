PRAGMA strict = true;
PRAGMA journal_mode = WAL; 

create table if not exists cache (
    `key` TEXT primary key,
    `value` TEXT not null
);