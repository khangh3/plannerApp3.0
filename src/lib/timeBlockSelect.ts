// Exceptions belong to the series through time_block_id. The replacement link
// is a second relationship to time_blocks, so PostgREST needs an explicit hint.
export const TIME_BLOCK_SELECT =
  "*, time_block_weekdays(weekday), time_block_exceptions!time_block_exceptions_time_block_id_fkey(id, occurrence_date, kind, replacement_block_id)";
