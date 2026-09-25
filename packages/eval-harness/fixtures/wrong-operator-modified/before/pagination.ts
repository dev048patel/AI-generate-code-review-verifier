export function hasNextPage(page: number, totalPages: number): boolean {
  return page < totalPages;
}
