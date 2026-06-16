// timeUtils.js

/**
 * מחזיר את הזמן הנוכחי בישראל בפורמט: YYYY-MM-DD HH:MM:SS
 */
export function getIsraelTimeForDB() {
    const options = { 
        timeZone: 'Asia/Jerusalem', 
        year: 'numeric', month: '2-digit', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', 
        hour12: false 
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const d = {};
    parts.forEach(({ type, value }) => { d[type] = value; });
    
    // מניעת באג בדפדפנים מסוימים שהופכים חצות ל-24 במקום 00
    let hour = d.hour === '24' ? '00' : d.hour;
    
    return `${d.year}-${d.month}-${d.day} ${hour}:${d.minute}:${d.second}`;
}

/**
 * חישוב חסין מאזורי זמן: בודק כמה דקות עברו מהזמן ששמור בטבלה לזמן הנוכחי בישראל
 */
export function getMinutesSinceIsraelDbTime(dbTimeStr) {
    if (!dbTimeStr) return Infinity;
    
    // מוסיפים 'Z' פיקטיבי לשני הזמנים כדי שהם יחושבו כאילו שניהם מאותו אזור זמן בדיוק, וכך מנטרלים את הפרשי ה-UTC.
    const pastMs = new Date(dbTimeStr.replace(' ', 'T') + 'Z').getTime();
    
    const nowIsraelStr = getIsraelTimeForDB();
    const nowMs = new Date(nowIsraelStr.replace(' ', 'T') + 'Z').getTime();
    
    return (nowMs - pastMs) / (1000 * 60);
}

/**
 * חישוב חסין מאזורי זמן מול התאריך והשעה שמגיעים מימות המשיח
 */
export function getMinutesSinceYemotTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return Infinity;
    
    const [day, month, year] = dateStr.split('/');
    const pastMs = new Date(`${year}-${month}-${day}T${timeStr}Z`).getTime();
    
    const nowIsraelStr = getIsraelTimeForDB();
    const nowMs = new Date(nowIsraelStr.replace(' ', 'T') + 'Z').getTime();
    
    return (nowMs - pastMs) / (1000 * 60);
}

/**
 * בדיקת שעות לילה/שעות אסורות לפי שעון ישראל
 */
export function isWithinBlockedHours(startHour, endHour) {
    const options = { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false };
    const currentHourStr = new Intl.DateTimeFormat('en-US', options).format(new Date());
    let hour = parseInt(currentHourStr, 10);
    if (hour === 24) hour = 0; // טיפול בחצות
    
    if (startHour < endHour) {
        // לדוגמה: 0 עד 7 (כולל חצות ועד 6:59:59)
        return hour >= startHour && hour < endHour;
    } else {
        // תמיכה בשעות הפוכות, נגיד מ-23 עד 7 בבוקר למחרת
        return hour >= startHour || hour < endHour;
    }
}
