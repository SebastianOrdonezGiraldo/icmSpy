import { z } from "zod";

export const COMPANY_TYPES = ["ips", "distribuidor", "drogueria", "laboratorio", "otro"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const CONTACT_KINDS = [
  "email",
  "phone",
  "whatsapp",
  "website",
  "instagram",
  "linkedin",
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const VALIDATION_STATUSES = ["unknown", "valid", "risky", "invalid", "bounced"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const LEGAL_BASES = [
  "open_data",
  "official_api",
  "own_website",
  "licensed",
  "manual",
] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

/** Filtros de la lista de empresas. Los usa la API para validar y la web para tipar. */
export const companyListQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  type: z.enum(COMPANY_TYPES).optional(),
  department: z.string().trim().min(1).max(80).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  hasEmail: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export interface CompanyListItem {
  id: string;
  nit: string | null;
  legalName: string;
  tradeName: string | null;
  domain: string | null;
  city: string | null;
  department: string | null;
  companyType: CompanyType;
  contactCount: number;
}

export interface CompanyListResponse {
  items: CompanyListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ContactPointDetail {
  id: string;
  kind: ContactKind;
  value: string;
  isRoleAddress: boolean;
  validationStatus: ValidationStatus;
  isPrimary: boolean;
  /** De dónde salió el dato: fuente y, si aplica, URL exacta. */
  sources: { sourceKey: string; url: string | null; observedAt: string }[];
}

export interface CompanyDetail extends Omit<CompanyListItem, "contactCount"> {
  cityCode: string | null;
  ciiuCodes: string[];
  createdAt: string;
  contactPoints: ContactPointDetail[];
}

export const loginSchema = z.object({
  email: z.email("Correo inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres"),
});
export type LoginInput = z.infer<typeof loginSchema>;
