import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, type Me } from "./api";
import { ReviewsList } from "./pages/ReviewsList";
import { ReviewDetail } from "./pages/ReviewDetail";
import { EvalReport } from "./pages/EvalReport";
import { TryIt } from "./pages/TryIt";
import { LiveGithub } from "./pages/LiveGithub";
import { Atlas } from "./pages/Atlas";
import { Report, ReportLanding } from "./pages/Report";

export function App() {
  // undefined = loading, null = signed out (sign-in required)
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api.me().then(setMe, () => setMe({ login: null, authRequired: false, demoEndpoints: true }));
  }, []);

  if (me === undefined) return null;
  if (me === null) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: "15vh auto", textAlign: "center" }}>
        <h2 className="card-title">🛡️ AI Code Review Verifier</h2>
        <p className="muted">Sign in to see reviews for the repositories you can access.</p>
        <a className="btn" href="/auth/login" style={{ display: "inline-block", textDecoration: "none" }}>
          Sign in with GitHub
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">🛡️</span> ACRV // CODE_REVIEW_VERIFIER
        </div>
        <nav className="nav">
          <NavLink to="/r" className={({ isActive }) => (isActive ? "active" : "")}>
            Repo Report
          </NavLink>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Reviews
          </NavLink>
          <NavLink to="/live" className={({ isActive }) => (isActive ? "active" : "")}>
            Live GitHub
          </NavLink>
          <NavLink to="/atlas" className={({ isActive }) => (isActive ? "active" : "")}>
            Repo Atlas
          </NavLink>
          <NavLink to="/eval-report" className={({ isActive }) => (isActive ? "active" : "")}>
            Eval report
          </NavLink>
          {me.demoEndpoints && (
            <NavLink to="/try" className={({ isActive }) => (isActive ? "active" : "")}>
              Try it
            </NavLink>
          )}
          {me.login && (
            <button
              className="secondary"
              onClick={() => api.logout().then(() => setMe(null))}
              title={`Signed in as ${me.login}`}
            >
              Sign out {me.login}
            </button>
          )}
        </nav>
      </div>

      <Routes>
        <Route path="/" element={<ReviewsList />} />
        <Route path="/reviews/:id" element={<ReviewDetail />} />
        <Route path="/live" element={<LiveGithub />} />
        <Route path="/atlas" element={<Atlas />} />
        <Route path="/r" element={<ReportLanding />} />
        <Route path="/r/:owner/:name" element={<Report />} />
        <Route path="/eval-report" element={<EvalReport />} />
        <Route path="/try" element={<TryIt />} />
      </Routes>
    </>
  );
}
