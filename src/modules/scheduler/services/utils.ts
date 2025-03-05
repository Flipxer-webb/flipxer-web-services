export const getTriggeredTime = (): string => {
    return `triggered time: timezone: ${new Date().toLocaleString("en-US", {
        timeZone: "Africa/Lagos",
    })}`;
};
