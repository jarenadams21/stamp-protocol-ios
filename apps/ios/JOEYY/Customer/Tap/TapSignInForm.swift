import SwiftUI

struct TapSignInForm: View {
    @Binding var username: String
    @Binding var password: String
    @Binding var createAccount: Bool
    let busy: Bool
    let authenticate: () -> Void
    @FocusState private var focusedField: Field?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.appAccent) private var accent

    private enum Field { case username, password }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if typeSize.isAccessibilitySize {
                Picker("Account", selection: $createAccount) {
                    Text("Create account").tag(true)
                    Text("Sign in").tag(false)
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
                .accessibilityIdentifier("tap.accountMode")
            } else {
                Picker("Account", selection: $createAccount) {
                    Text("Create account").tag(true)
                    Text("Sign in").tag(false)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("tap.accountMode")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Username").font(.footnote).foregroundStyle(Color.muted)
                TextField("Username", text: $username,
                          prompt: Text("e.g. joeyy").foregroundStyle(Color.muted))
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .username)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .password }
                    .accessibilityIdentifier("tap.username")
            }
            .padding(14)
            .background(Color.paper, in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(focusedField == .username ? accent.color : Color.rule, lineWidth: 1)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Password").font(.footnote).foregroundStyle(Color.muted)
                SecureField("Password", text: $password,
                            prompt: Text(typeSize.isAccessibilitySize ? "Password" : "12-128 characters")
                                .foregroundStyle(Color.muted))
                    .textContentType(createAccount ? .newPassword : .password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .accessibilityIdentifier("tap.password")
            }
            .padding(14)
            .background(Color.paper, in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(focusedField == .password ? accent.color : Color.rule, lineWidth: 1)
            }

            if createAccount {
                Text("Username: 3-40 letters, numbers, . _ -\nPassword: 12-128 characters. Keep it to return to your cards.")
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: submit) {
                HStack(spacing: 10) {
                    Text(createAccount ? "Create account" : "Sign in")
                    if busy {
                        ProgressView().tint(Color.muted)
                    } else {
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                }
            }
            .buttonStyle(PrimaryButton())
            .disabled(busy || username.isEmpty || password.isEmpty)
            .accessibilityIdentifier("tap.authenticate")
        }
        .padding(20)
        .modifier(SurfacePanel())
        .disabled(busy)
        .onChange(of: createAccount) { focusedField = nil }
    }

    private func submit() {
        guard !busy, !username.isEmpty, !password.isEmpty else { return }
        focusedField = nil
        authenticate()
    }
}

#Preview {
    TapSignInForm(username: .constant(""), password: .constant(""),
                  createAccount: .constant(true), busy: false, authenticate: {})
        .padding(24)
        .background { AppBackground() }
}
