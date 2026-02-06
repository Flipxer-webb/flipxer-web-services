#!/bin/sh
export PGPASSWORD="Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc"
psql -h "dpg-d5v3gcnpm1nc73c9q6fg-a.oregon-postgres.render.com" -U "resolve_db_user" -d "resolve_db_4a8l_b6ra_o5el_m1sw_p0r2_x75k_ayye" -f /tmp/rename_table.sql
