export interface HoursInterval {
  startMin: number;
  endMin: number;
}

/** index 0 = Sunday ... 6 = Saturday */
export type WeeklyHours = HoursInterval[][];

export const emptyWeek = (): WeeklyHours => [[], [], [], [], [], [], []];

export interface EngineBusiness {
  id: string;
  timezone: string;
  slotIntervalMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  weeklyHours: WeeklyHours;
}

export interface EngineDateException {
  date: string;
  kind: 'closed' | 'special_hours';
  intervals: HoursInterval[];
}

export interface EngineStaff {
  id: string;
  displayName: string;
  acceptsBookings: boolean;
  archived: boolean;
  sortOrder: number;
  serviceIds: string[];
  usesBusinessHours: boolean;
  weeklyHours: WeeklyHours;
  breaks: WeeklyHours;
  maxParticipants: number | null;
}

export interface EngineResource {
  id: string;
  name: string;
  quantity: number;
  personCapacity: number | null;
  hasHours: boolean;
  weeklyHours: WeeklyHours;
  archived: boolean;
}

export interface EngineService {
  id: string;
  name: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  capacity: number;
  maxPartySize: number;
  requiresStaff: boolean;
  bookingMode: 'slots' | 'sessions';
  slotIntervalMin: number | null;
  acceptsBookings: boolean;
  isPublic: boolean;
  archived: boolean;
  resourceIds: string[];
  staffIds: string[];
}

export interface EngineBlock {
  id: string;
  scope: 'business' | 'staff' | 'resource';
  targetId: string | null;
  start: number;
  end: number;
}

export interface EngineAllocation {
  kind: 'staff' | 'resource';
  targetId: string;
  start: number;
  end: number;
  sessionKey: string;
  bookingId: string | null;
  occurrenceId: string | null;
}

/** An active booking, reduced to what the engine needs (capacity + load balancing). */
export interface EngineBooking {
  id: string;
  serviceId: string;
  staffId: string | null;
  sessionKey: string;
  occurrenceId: string | null;
  start: number;
  partySize: number;
}

export interface EngineOccurrence {
  id: string;
  serviceId: string;
  staffId: string | null;
  localDate: string;
  start: number;
  end: number;
  occupiedStart: number;
  occupiedEnd: number;
  capacity: number;
  status: 'scheduled' | 'cancelled';
  resourceIds: string[];
}

export interface EngineInput {
  business: EngineBusiness;
  exceptions: EngineDateException[];
  staff: EngineStaff[];
  resources: EngineResource[];
  services: EngineService[];
  blocks: EngineBlock[];
  allocations: EngineAllocation[];
  bookings: EngineBooking[];
  occurrences: EngineOccurrence[];
}

/**
 * public: customer booking page — every rule applies.
 * admin: staff/owner manual booking — booking window (min notice / max advance / grid / public flag) waived.
 * force: owner forced booking — additionally hours and blocks waived. Conflicts & capacity are NEVER waived.
 */
export type CheckMode = 'public' | 'admin' | 'force';

export type ReasonCode =
  | 'SERVICE_UNAVAILABLE'
  | 'PARTY_SIZE'
  | 'TOO_SOON'
  | 'TOO_FAR'
  | 'OFF_GRID'
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'BUSINESS_BLOCKED'
  | 'RESOURCE_UNAVAILABLE'
  | 'RESOURCE_HOURS'
  | 'RESOURCE_BLOCKED'
  | 'RESOURCE_FULL'
  | 'STAFF_UNAVAILABLE'
  | 'STAFF_HOURS'
  | 'STAFF_BLOCKED'
  | 'STAFF_BUSY'
  | 'CAPACITY_FULL'
  | 'NO_STAFF'
  | 'OCCURRENCE_UNAVAILABLE';

export interface Reason {
  code: ReasonCode;
  message: string;
  staffId?: string;
  resourceId?: string;
}

export interface SlotRequest {
  serviceId: string;
  /** null = おまかせ */
  staffId: string | null;
  start: number;
  partySize: number;
  now: number;
  mode: CheckMode;
  /** When rescheduling: ignore this booking's own occupancy. */
  excludeBookingId?: string;
}

export interface SlotOk {
  ok: true;
  serviceId: string;
  staffId: string | null;
  start: number;
  end: number;
  occupiedStart: number;
  occupiedEnd: number;
  sessionKey: string | null; // null => new single session (caller assigns b:<bookingId>)
  joinsExisting: boolean;
  capacity: number;
  remainingAfter: number;
  resourceIds: string[];
  occurrenceId: string | null;
}

export interface SlotNg {
  ok: false;
  reasons: Reason[];
}

export type SlotResult = SlotOk | SlotNg;

export interface Slot {
  start: number;
  end: number;
  staffIds: string[];
  /** remaining seats for group services (max over available staff), null for 1:1 */
  remaining: number | null;
  occurrenceId: string | null;
}
