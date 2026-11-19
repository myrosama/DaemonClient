import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_ui/immich_ui.dart';

void main() {
  // Found in P2 2.3's Gate 2: the login form sent an empty password, as
  // ImmichTextInput showed its validator's message but never failed the form.
  testWidgets('a field that fails its validator stops the submit', (tester) async {
    var submitted = 0;
    final text = TextEditingController();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ImmichForm(
            submitText: 'Login',
            onSubmit: () => submitted++,
            child: ImmichTextInput(
              label: 'Password',
              controller: text,
              validator: (v) => (v ?? '').isEmpty ? 'required' : null,
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Login'));
    await tester.pumpAndSettle();
    expect(submitted, 0);
    expect(find.text('required'), findsOneWidget);

    text.text = 'filled';
    await tester.tap(find.text('Login'));
    await tester.pumpAndSettle();
    expect(submitted, 1);
  });
}
