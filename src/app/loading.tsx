// Shown the moment a page is opened from the menu, while the server prepares it, so a tap
// always answers at once instead of leaving the previous page on screen.
export default function Loading() {
  return (
    <div className="shell page-loading" aria-busy="true" aria-label="載入中">
      <span className="pl-bar pl-title" />
      <span className="pl-bar pl-line" />
      <div className="pl-card"><span className="pl-bar" /><span className="pl-bar pl-short" /><span className="pl-bar pl-line" /></div>
      <div className="pl-card"><span className="pl-bar" /><span className="pl-bar pl-short" /></div>
    </div>
  );
}
