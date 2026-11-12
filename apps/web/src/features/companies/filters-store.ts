import type { CompanyType } from "@icmspy/shared";
import { create } from "zustand";

interface CompanyFilters {
  q: string;
  type: CompanyType | "";
  hasEmail: boolean;
  page: number;
  set(patch: Partial<Pick<CompanyFilters, "q" | "type" | "hasEmail">>): void;
  setPage(page: number): void;
}

/** Filtros de la lista. Viven fuera del componente para conservarse al navegar a la ficha. */
export const useCompanyFilters = create<CompanyFilters>((set) => ({
  q: "",
  type: "",
  hasEmail: false,
  page: 1,
  set: (patch) => set({ ...patch, page: 1 }),
  setPage: (page) => set({ page }),
}));
