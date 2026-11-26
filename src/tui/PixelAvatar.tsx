import { memo } from 'react';
import { Box, Text } from 'ink';
import Image from 'ink-picture';

type PixelAvatarProps = {
    url?: string | null;
    size?: number;
};

export const PixelAvatar = memo(function PixelAvatar({
    url,
    size = 12
}: PixelAvatarProps) {
    const height = Math.ceil(size / 2);

    if (!url) {
        return (
            <Box
                width={size}
                height={height}
                borderStyle="round"
                borderColor="gray"
                alignItems="center"
                justifyContent="center"
            >
                <Text color="gray">BOT</Text>
            </Box>
        );
    }

    return (
		<Image
			src={url}
			width={size}
			height={height}
			objectFit="cover"
			protocol="sixel"
			alt=""
		/>
    );
});
