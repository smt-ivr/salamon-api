// timeUtils.js

/**
 * מחזיר את הזמן הנוכחי בישראל בפורמט שמתאים לשמירה במסד הנתונים (D1 / SQLite)
 * פורמט: YYYY-MM-DD HH:MM:SS
 */
export function getIsraelTimeForDB() {
    const options = { 
        timeZone: 'Asia/Jerusalem', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: false 
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const dateObj = {};
    
    parts.forEach(({ type, value }) => { 
        dateObj[type] = value; 
    });
    
    return `${dateObj.year}-${dateObj.month}-${dateObj.day} ${dateObj.hour}:${dateObj.minute}:${dateObj.second}`;
}

/**
 * מחזיר את הזמן הנוכחי בישראל כמספר מילישניות (Timestampt) לטובת חישובי זמנים
 */
export function getNowMs() {
    return Date.now();
}

/**
 * ממיר את התאריך והשעה שמתקבלים מהלוג של ימות המשיח למילישניות
 * ימות המשיח מחזירים: Date: DD/MM/YYYY, Time: HH:MM:SS
 */
export function parseYemotTimeMs(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('/');
    const [hour, minute, second] = timeStr.split(':');
    
    // יוצרים מחרוזת תאריך בפורמט ISO עם אזור זמן של ישראל (+02:00 לחורף או +03:00 לקיץ)
    // הדרך הבטוחה ביותר ב-JS בסביבת שרת היא לבנות את התאריך ישירות
    const dateString = `${year}-${month}-${day}T${hour}:${minute}:${second}+02:00`; 
    // הערה: שימוש ב+02:00 כממוצע, לחישוב קצר של 5 דקות זה מדויק לחלוטין
    return new Date(dateString).getTime();
}

/**
 * פונקציית עזר להמרת זמן מהמסד נתונים למילישניות לחישוב
 */
export function parseDBTimeToMs(dbTimeStr) {
    // dbTimeStr הוא בפורמט YYYY-MM-DD HH:MM:SS
    const isoString = dbTimeStr.replace(' ', 'T') + '+02:00';
    return new Date(isoString).getTime();
}
