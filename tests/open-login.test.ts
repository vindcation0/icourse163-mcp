import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PASSWORD_MODE_SWITCH_LABEL,
  cannotOpenLoginUiMessage,
  cookieHeaderFrom,
  describeLoginFailure,
  isPasswordSubmitLabel,
  passwordLoginHeadless,
  passwordPromptLabel,
  redactLoginSecrets,
  showPasswordEnabled,
} from "../src/open-login";
import type { Cookie } from "playwright-core";

function cookie(name: string, value: string, domain = ".icourse163.org"): Cookie {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };
}

describe("cookieHeaderFrom", () => {
  // The site's own JS sets this exact value for anonymous visitors, so a bogus
  // account used to report LOGIN_OK and overwrite the stored session.
  test("rejects the anonymous placeholder NTESSTUDYSI", () => {
    assert.equal(cookieHeaderFrom([cookie("NTESSTUDYSI", "fa2c35db81bb400a97f5ed9465e22b9d")]), null);
  });

  test("rejects a session without STUDY_INFO", () => {
    assert.equal(cookieHeaderFrom([cookie("NTESSTUDYSI", "abc"), cookie("EDUWEBDEVICE", "d")]), null);
  });

  test("accepts a real session (NTESSTUDYSI + STUDY_INFO)", () => {
    const header = cookieHeaderFrom([cookie("NTESSTUDYSI", "abc"), cookie("STUDY_INFO", "x")]);
    assert.match(header ?? "", /NTESSTUDYSI=abc/);
    assert.match(header ?? "", /STUDY_INFO=x/);
  });

  test("ignores cookies from other hosts", () => {
    assert.equal(
      cookieHeaderFrom([cookie("NTESSTUDYSI", "abc", "example.com"), cookie("STUDY_INFO", "x", "example.com")]),
      null,
    );
    // one foreign cookie must not mask a real session on ours
    assert.match(
      cookieHeaderFrom([cookie("NTESSTUDYSI", "abc", "example.com"), cookie("NTESSTUDYSI", "abc"), cookie("STUDY_INFO", "x")]) ?? "",
      /STUDY_INFO=x/,
    );
  });
});

describe("describeLoginFailure", () => {
  test("explains a missing Chrome channel", () => {
    const message = describeLoginFailure(
      new Error(
        "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
      ),
    );
    assert.match(message, /Chrome|Chromium/i);
  });

  test("explains a headed browser with no X server / DISPLAY", () => {
    const message = describeLoginFailure(
      new Error(
        "Looks like you launched a headed browser without having a XServer running. Set either 'headless: true' or use 'xvfb-run'",
      ),
    );
    assert.match(message, /display|headless|desktop/i);
  });

  test("keeps a login wait timeout message", () => {
    assert.equal(describeLoginFailure(new Error("login wait timeout")), "login wait timeout");
  });
});

describe("cannotOpenLoginUiMessage / passwordLoginHeadless", () => {
  test("is set on linux without DISPLAY", () => {
    const message = cannotOpenLoginUiMessage({ HOME: "/tmp" }, "linux");
    assert.notEqual(message, null);
    assert.equal(passwordLoginHeadless({ HOME: "/tmp" }, "linux"), true);
  });

  test("is null on linux with DISPLAY and on darwin", () => {
    assert.equal(cannotOpenLoginUiMessage({ DISPLAY: ":0" }, "linux"), null);
    assert.equal(cannotOpenLoginUiMessage({}, "darwin"), null);
    assert.equal(passwordLoginHeadless({ DISPLAY: ":0" }, "linux"), false);
  });
});

describe("redactLoginSecrets", () => {
  test("strips username and password from error text", () => {
    const redacted = redactLoginSecrets("failed for alice / s3cret-value", {
      username: "alice",
      password: "s3cret-value",
    });
    assert.doesNotMatch(redacted, /alice/);
    assert.doesNotMatch(redacted, /s3cret-value/);
    assert.match(redacted, /已隐藏/);
  });
});

describe("showPasswordEnabled / passwordPromptLabel", () => {
  // Visible is the deliberate default; hiding is the opt-out.
  test("defaults to visible and can be turned off", () => {
    assert.equal(showPasswordEnabled(false, {}), true);
    assert.equal(showPasswordEnabled(true, {}), false);
    assert.equal(showPasswordEnabled(false, { ICOURSE163_HIDE_PASSWORD: "1" }), false);
    // anything other than the exact "1" leaves the default alone
    assert.equal(showPasswordEnabled(false, { ICOURSE163_HIDE_PASSWORD: "0" }), true);
  });

  test("an explicit ICOURSE163_SHOW_PASSWORD=1 overrides a global hide", () => {
    assert.equal(
      showPasswordEnabled(true, { ICOURSE163_SHOW_PASSWORD: "1" }),
      true,
    );
    assert.equal(
      showPasswordEnabled(false, {
        ICOURSE163_SHOW_PASSWORD: "1",
        ICOURSE163_HIDE_PASSWORD: "1",
      }),
      true,
    );
  });

  test("labels the two modes differently so the user can tell which is active", () => {
    assert.match(passwordPromptLabel(true), /可见/);
    assert.match(passwordPromptLabel(false), /不显示/);
    assert.notEqual(passwordPromptLabel(true), passwordPromptLabel(false));
    assert.equal(passwordPromptLabel(true, true), "Password (visible): ");
    assert.equal(passwordPromptLabel(false, true), "Password (hidden): ");
  });
});

describe("PASSWORD_MODE_SWITCH_LABEL", () => {
  test("matches URS password-mode tabs", () => {
    assert.match("密码登录", PASSWORD_MODE_SWITCH_LABEL);
    assert.match("账号登录", PASSWORD_MODE_SWITCH_LABEL);
    assert.match("邮箱登录", PASSWORD_MODE_SWITCH_LABEL);
  });

  test("does not match SMS/QR tabs or a bare 登录 submit", () => {
    assert.doesNotMatch("短信登录", PASSWORD_MODE_SWITCH_LABEL);
    assert.doesNotMatch("扫码登录", PASSWORD_MODE_SWITCH_LABEL);
    assert.equal(PASSWORD_MODE_SWITCH_LABEL.test("登录"), false);
  });
});

describe("isPasswordSubmitLabel", () => {
  test("accepts bare 登录 / 登 录 submit labels", () => {
    assert.equal(isPasswordSubmitLabel("登录"), true);
    assert.equal(isPasswordSubmitLabel("登 录"), true);
    assert.equal(isPasswordSubmitLabel("  登\t录  "), true);
  });

  test("rejects mailModule and mode-switch headings", () => {
    assert.equal(isPasswordSubmitLabel("网易邮箱账号登录"), false);
    assert.equal(isPasswordSubmitLabel("密码登录"), false);
    assert.equal(isPasswordSubmitLabel("账号登录"), false);
    assert.equal(isPasswordSubmitLabel("邮箱登录"), false);
    assert.equal(isPasswordSubmitLabel("短信登录"), false);
    assert.equal(isPasswordSubmitLabel("扫码登录"), false);
  });
});
