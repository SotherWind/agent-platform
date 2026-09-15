import { useState } from "react";
import { isLoggedIn, logout } from "./api/auth";
import ChatPage from "./pages/ChatPage";
import LoginPage from "./pages/LoginPage";

export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn());

  if (!authed) {
    return <LoginPage onSuccess={() => setAuthed(true)} />;
  }

  return (
    <ChatPage
      onLogout={() => {
        logout();
        setAuthed(false);
      }}
    />
  );
}
