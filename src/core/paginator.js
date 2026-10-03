// Port of App\Core\Paginator
class Paginator {
  constructor(total, perPage = 15, currentPage = 1) {
    this.total = Math.max(0, parseInt(total, 10) || 0);
    this.perPage = Math.max(1, parseInt(perPage, 10) || 15);
    this.lastPage = Math.max(1, Math.ceil(this.total / this.perPage));
    this.currentPage = Math.min(Math.max(1, parseInt(currentPage, 10) || 1), this.lastPage);
    this.offset = (this.currentPage - 1) * this.perPage;
  }

  hasPages() { return this.lastPage > 1; }

  from() { return this.total === 0 ? 0 : this.offset + 1; }
  to() { return Math.min(this.offset + this.perPage, this.total); }

  getLinks() {
    const links = [];
    const start = Math.max(1, this.currentPage - 2);
    const end = Math.min(this.lastPage, this.currentPage + 2);
    for (let i = start; i <= end; i++) {
      links.push({ page: i, active: i === this.currentPage });
    }
    return links;
  }
}

module.exports = Paginator;
