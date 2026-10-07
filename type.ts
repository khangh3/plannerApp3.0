export type Availability = "busy" | "flexible";
export type Category = {
  id: number;
  userId: string;
  name: string;
  color: string;
};
export type TimeBlock = {
  id: string;
  userId: string;
  title: string;
  categoryId: number;
  availability: Availability;
  startTime: string;
  endTime: string;
  description?: string;
  recurringStartDate?: string;
  recurringEndDate?: string;
  weekdays: number[];
  timeZone: string;
};
export type TimeBlockDraft = Omit<TimeBlock, "id" | "userId">;
export type TimeBlockException = {
  id: number;
  timeBlockId: string;
  date: string;
};
// A visible instance of a block; originalDate identifies one recurring day for skip/restore.
export type TimeBlockOccurrence = {
  id: string;
  timeBlockId: string;
  originalDate: string;
  startTime: string;
  endTime: string;
  block: TimeBlock;
};
