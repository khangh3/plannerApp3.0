import type { Dayjs } from "dayjs";

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
  startTime: Dayjs;
  endTime: Dayjs;
  description?: string;
  recurringStartDate?: Dayjs;
  recurringEndDate?: Dayjs;
  weekdays: number[];
  timezone: string;
};
export type TimeBlockDraft = Omit<TimeBlock, "id" | "userId">;
export type TimeBlockException = {
  id: number;
  timeBlockId: string;
  date: string;
};
