// קובץ: auth.js

export async function handleUpdateProfile(request, env) {
    const body = await request.json().catch(() => ({}));
    const { userToken, newEmail, receiveEmails, googleLoginOnly, password } = body;

    if (!userToken) return Response.json({ error: "חסר אימות משתמש (טוקן)" }, { status: 401 });

    const user = await authenticateUser(env.DB, userToken);
    if (!user) return Response.json({ error: "הטוקן שגוי או שפג תוקפו" }, { status: 401 });

    if (user.auth_method === 'password') {
        if (!password) return Response.json({ error: "חובה להזין את הסיסמה שלך על מנת לשמור שינויים." }, { status: 400 });
        if (user.password !== password) return Response.json({ error: "הסיסמה שהוזנה שגויה, לא ניתן לשמור שינויים." }, { status: 401 });
    }

    let finalEmail = user.email;
    let finalReceive = user.receive_emails ?? 1;
    let finalGoogleOnly = user.google_login_only ?? 0;
    
    let messages = [];
    let errors = [];

    if (receiveEmails !== undefined) {
        const requestedReceive = receiveEmails ? 1 : 0;
        if (requestedReceive !== finalReceive) {
            finalReceive = requestedReceive;
            messages.push("הגדרות קבלת המיילים עודכנו.");
        }
    }

    if (googleLoginOnly !== undefined) {
        const requestedGoogleOnly = googleLoginOnly ? 1 : 0;
        if (requestedGoogleOnly !== finalGoogleOnly) {
            
            // הגדרה חדשה: בדיקה האם קיים אימייל קיים או שסופק אחד בבקשה הנוכחית
            const targetEmail = newEmail !== undefined ? (newEmail || null) : user.email;
            
            if (requestedGoogleOnly === 1 && user.auth_method === 'password') {
                errors.push("לא ניתן להפעיל 'כניסה באמצעות גוגל בלבד' כשמחוברים עם סיסמה. (ההגדרה נדחתה)");
            } else if (requestedGoogleOnly === 1 && !targetEmail) {
                // החסימה החדשה נכנסת לכאן
                errors.push("לא ניתן להפעיל 'כניסה באמצעות גוגל בלבד' ללא כתובת אימייל מעודכנת. (ההגדרה נדחתה)");
            } else {
                finalGoogleOnly = requestedGoogleOnly;
                messages.push("הגדרת הכניסה באמצעות גוגל עודכנה.");
            }
        }
    }

    if (newEmail !== undefined) {
        const requestedEmail = newEmail || null;
        if (requestedEmail !== user.email) {
            if (user.google_login_only === 1 && finalGoogleOnly === 1) {
                errors.push("לא ניתן לשנות אימייל כש'כניסה מגוגל בלבד' מופעלת. (עדכון המייל נדחה)");
            } else {
                finalEmail = requestedEmail;
                messages.push("כתובת האימייל עודכנה.");
            }
        }
    }

    if (messages.length === 0 && errors.length === 0) {
        return Response.json({ success: true, message: "לא נשלחו נתונים חדשים לעדכון." });
    }

    try {
        await env.DB.prepare(
            "UPDATE users SET email = ?, receive_emails = ?, google_login_only = ? WHERE phone = ?"
        ).bind(finalEmail, finalReceive, finalGoogleOnly, user.phone).run();

        if (finalGoogleOnly === 1 && user.google_login_only === 0 && finalEmail) {
            try {
                const userName = await getNameFromIni(user.phone, env.YEMOT_TOKEN) || "משתמש יקר";
                const userIp = request.headers.get('cf-connecting-ip') || 'לא ידוע';
                await sendSecurityAlert(env, finalEmail, userName, 'google_only', userIp, null);
            } catch(e) { console.error("Error sending google_only alert", e); }
        }

        const isSuccess = messages.length > 0;
        const hasErrors = errors.length > 0;
        let finalMessage = "";
        
        if (isSuccess && hasErrors) finalMessage = "בוצע עדכון חלקי:\n" + messages.join("\n") + "\n\nשגיאות:\n" + errors.join("\n");
        else if (isSuccess && !hasErrors) finalMessage = "כל השינויים נשמרו בהצלחה:\n" + messages.join("\n");
        else if (!isSuccess && hasErrors) return Response.json({ error: "העדכון נכשל לחלוטין:\n" + errors.join("\n") }, { status: 400 });

        return Response.json({ success: true, message: finalMessage, partialUpdate: isSuccess && hasErrors });
    } catch (e) {
        return Response.json({ error: "שגיאה במסד הנתונים בעת השמירה. ייתכן והאימייל תפוס." }, { status: 400 });
    }
}
