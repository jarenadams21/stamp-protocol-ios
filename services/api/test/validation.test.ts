import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { characterCount, contrast, parseBusiness, parseProgram, parseTheme } from "../src/validation.ts";
import { validTheme } from "./helpers.ts";

const code = (fn: () => unknown) => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof ApiError);
        return error.code;
    }
    assert.fail("expected an ApiError");
};

test("every CardPalette preset in the app passes the 4.5:1 contrast rule", () => {
    // JOEYY/BusinessModels.swift CardPalette.all
    const presets = [
        ["#F7EFD9", "#2F241E", "#2F241E", "#F7EFD9"],
        ["#F5A174", "#351B13", "#5C2C20", "#FFE6D5"],
        ["#DDE9F2", "#213849", "#223844", "#DCE8F2"],
        ["#E8DFC8", "#353E2D", "#31382D", "#F0E7D2"],
        ["#F2CB58", "#443015", "#49391D", "#FFE6A5"],
        ["#CED9BA", "#283B2B", "#293D30", "#E0EACF"],
        ["#D6C9EC", "#342545", "#392A49", "#EEDFFB"],
    ] as const;
    for (const [lightPaper, lightInk, darkPaper, darkInk] of presets) {
        assert.doesNotThrow(() => parseTheme({ ...validTheme, lightPaper, lightInk, darkPaper, darkInk }));
    }
    assert.equal(Math.round(contrast("#000000", "#FFFFFF")), 21);
});

test("themes are normalized and rejected when invalid", () => {
    assert.equal(parseTheme({ ...validTheme, lightPaper: "#f7efd9" }).lightPaper, "#F7EFD9");
    assert.equal(code(() => parseTheme({ ...validTheme, lightInk: "#EEEEEE" })), "invalidTheme");
    assert.equal(code(() => parseTheme({ ...validTheme, darkInk: "F7EFD9" })), "invalidTheme");
    assert.equal(code(() => parseTheme({ ...validTheme, typeface: "comic" })), "invalidTheme");
    assert.equal(code(() => parseTheme({ ...validTheme, artwork: "paper" })), "invalidTheme");
    assert.equal(code(() => parseTheme({ ...validTheme, allowsMotion: "yes" })), "invalidTheme");
    assert.equal(code(() => parseTheme({ ...validTheme, coverURL: "https://example.com/a.jpg" })), "invalidTheme");
});

test("program rules match ProgramDraft.validated()", () => {
    const base = { requiredPunches: 10, rewardDescription: "  One drink  ", theme: validTheme };
    assert.equal(parseProgram(base).rewardDescription, "One drink");
    assert.equal(code(() => parseProgram({ ...base, requiredPunches: 2 })), "invalidPunches");
    assert.equal(code(() => parseProgram({ ...base, requiredPunches: 13 })), "invalidPunches");
    assert.equal(code(() => parseProgram({ ...base, requiredPunches: 4.5 })), "invalidPunches");
    assert.equal(code(() => parseProgram({ ...base, rewardDescription: "   " })), "missingReward");
    assert.equal(code(() => parseProgram({ ...base, rewardDescription: "x".repeat(61) })), "rewardTooLong");
    assert.doesNotThrow(() => parseProgram({ ...base, rewardDescription: "x".repeat(60) }));
    // The business's own repeat-stamp limit is optional; absent or null means none.
    assert.equal(parseProgram(base).minMinutesBetweenStamps, null);
    assert.equal(parseProgram({ ...base, minMinutesBetweenStamps: null }).minMinutesBetweenStamps, null);
    assert.equal(parseProgram({ ...base, minMinutesBetweenStamps: 30 }).minMinutesBetweenStamps, 30);
    for (const minutes of [0, 1441, 2.5, "30"]) {
        assert.equal(code(() => parseProgram({ ...base, minMinutesBetweenStamps: minutes })), "invalidMinMinutes");
    }
});

test("business rules match PartnerStore.saveBusiness", () => {
    assert.deepEqual(parseBusiness({ name: " Norema ", location: " Seattle " }), {
        name: "Norema",
        location: "Seattle",
        timeZone: "UTC",
    });
    assert.equal(code(() => parseBusiness({ name: "" })), "missingName");
    assert.equal(code(() => parseBusiness({ name: "x".repeat(41) })), "nameTooLong");
    assert.equal(code(() => parseBusiness({ name: "a", location: "x".repeat(121) })), "locationTooLong");
    assert.equal(code(() => parseBusiness({ name: "a", timeZone: "Mars/Olympus" })), "invalidTimeZone");
    assert.equal(parseBusiness({ name: "a", timeZone: "America/Los_Angeles" }).timeZone, "America/Los_Angeles");
});

test("limits count characters the way Swift does", () => {
    assert.equal(characterCount("☕️"), 1);
    assert.equal(characterCount("👩‍👩‍👧"), 1);
    assert.doesNotThrow(() => parseBusiness({ name: "☕️".repeat(40) }));
});
