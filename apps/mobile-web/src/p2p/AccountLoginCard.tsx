import { useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from "@slice/design-system";
import { CircleAlert, LogIn } from "lucide-react";
import { signalingLogin, signalingRegister } from "./signaling";

export function AccountLoginCard({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!email.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }
    if (mode === "register" && password.length < 12) {
      setError("密码至少需要 12 个字符");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (mode === "login") await signalingLogin(email.trim(), password);
      else await signalingRegister(email.trim(), password);
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card variant="outlined">
      <CardHeader>
        <LogIn className="mb-2 size-8 text-muted" />
        <CardTitle>{mode === "login" ? "登录 Slice 账号" : "注册 Slice 账号"}</CardTitle>
        <CardDescription>
          {mode === "login" ? "登录后，这台 Mac 会自动绑定到你的账号。" : "注册后自动登录，这台 Mac 会绑定到你的账号。"}
        </CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-3 p-5 pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="slice-account-email">账号邮箱</FieldLabel>
            <Input
              id="slice-account-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              autoComplete="username"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="slice-account-password">密码</FieldLabel>
            <Input
              id="slice-account-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
              placeholder={mode === "register" ? "至少 12 个字符" : "输入密码"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </Field>
          {mode === "register" ? (
            <Field>
              <FieldLabel htmlFor="slice-account-confirm-password">确认密码</FieldLabel>
              <Input
                id="slice-account-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
                placeholder="再次输入密码"
                autoComplete="new-password"
              />
            </Field>
          ) : null}
        </FieldGroup>
        <Button onClick={() => void submit()} disabled={submitting}>
          {submitting ? (mode === "login" ? "登录中…" : "注册中…") : mode === "login" ? "登录并上线" : "注册并上线"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}
        >
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </Button>
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{mode === "login" ? "登录失败" : "注册失败"}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </Card>
  );
}
